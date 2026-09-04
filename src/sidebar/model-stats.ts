// What each model has COST this browsing session, and what happened on the machine's timeline.
//
// Residency (the resource panel's other half) answers "what is loaded". This answers "and was it worth the
// VRAM": tokens in and out, how many calls, and the rate — with `genBasis` saying whether that rate came from
// Ollama's own generation timings or from wall clock, because a number that silently mixes the two implies a
// precision it does not have.
//
// Pure, and deliberately over a MINIMAL shape rather than the sidebar's Session type: the aggregation is the
// part worth testing, and it should not need a whole debug-event fixture to exercise.
import { runStats, type RunStats, type TokenUsage, type GenPhase } from "../contract";
import type { ResourceEvent } from "../resource-model";

/** The little a session must expose for these to work. */
export interface UsageSource {
    hash: string;
    /** What this session IS. Only an AGENT session carries this — a chat leaves it unset — so the container
     *  is a run when it says "agent" and a session otherwise. The bar reads "run · <model>" for an agent,
     *  which is simply untrue of a `ml.chat()`: there is no run, and the lane should not assert one. */
    kind?: "chat" | "agent" | "embed";
    /** The model the run/chat resolved to — the fallback owner of any usage a turn doesn't name itself. */
    model?: string | null;
    /** When the run STARTED and when it was last heard from. A step's timestamp is when it FINISHED, so a run
     *  measured from its steps alone begins after its own first model call — and the load that call waited
     *  through then sits outside the run that caused it. */
    createdTs?: number;
    lastTs?: number;
    turns?: { ts?: number; model?: string | null; usage?: TokenUsage | null }[];
    /** A model call in flight RIGHT NOW. The ONLY stamp for it: a step's `ts` is when the step FINISHED, so
     *  without this a generation is invisible until it is over and then appears back-dated. */
    liveTurn?: { step: number; startedTs: number; phases?: GenPhase[] } | null;
    steps?: {
        seq?: number; step?: number; ts?: number;
        tool?: string;
        /** This step has not finished. Its `ts` is when it STARTED (the loop's in-flight emit), the opposite of
         *  a completed step's, which is why an open span is built from it directly rather than backwards. */
        pending?: boolean;
        /** …and it is sitting at an approval gate, so what is elapsing is a human, not the machine. */
        awaitingApproval?: boolean;
        /** How long the tool itself ran (the loop measures it around the dispatch, excluding the gate). */
        toolMs?: number;
        /** Plumbing between the model call returning and the tool starting — see AgentStep.dispatchMs. */
        dispatchMs?: number;
        /** What a REMOTE executor said IT spent. `toolMs` is our wall clock around the whole dispatch, so it
         *  also contains the network; this is what lets the two be drawn apart. */
        remoteMs?: { durationMs: number; queuedMs?: number } | null;
        /** How long the approval gate was open — the human's time, measured separately for exactly that
         *  reason: it is the step's wall clock but not the machine's work. */
        approveMs?: number;
        usage?: TokenUsage | null;
        /** Delegated vision sub-calls (look/locate/verify) — a DIFFERENT model, and attributing them to the
         *  driver is how a reader model's cost disappears from the ledger. */
        subUsage?: {
            byModel?: { model: string; prompt: number; completion: number; calls: number }[];
            /** The individual delegated calls, each with its own timing — what makes them drawable. */
            calls_?: { model: string; ts: number; ms: number; prompt: number; completion: number }[];
        } | null;
    }[];
}

/** Every model that spent tokens, with its aggregate. Keyed by the RESOLVED model id — the one that actually
 *  ran, never the one that was asked for (`extend: "utility"` resolves to a different model, and a ledger that
 *  said "default" would be unattributable). */
export function usageByModel(sessions: readonly UsageSource[]): Record<string, RunStats> {
    const per: Record<string, TokenUsage[]> = {};
    const extraCalls: Record<string, number> = {};
    const add = (model: string | null | undefined, u: TokenUsage | null | undefined) => {
        if (!model || !u) return;
        (per[model] ||= []).push(u);
    };
    for (const s of sessions) {
        for (const t of s.turns || []) add(t.model || s.model, t.usage);
        for (const st of s.steps || []) {
            add(s.model, st.usage);
            // A sub-call reports counts but no timing, so it contributes tokens and calls without pretending
            // to a rate — runStats simply finds no timing to divide by.
            for (const b of st.subUsage?.byModel || []) {
                add(b.model, { promptTokens: b.prompt, completionTokens: b.completion, totalTokens: b.prompt + b.completion });
                // Sub-calls arrive already summed, so the tokens are exact but the per-call split isn't there.
                // We know how MANY there were, so the count is corrected below rather than reported as one.
                if (b.calls > 1) extraCalls[b.model] = (extraCalls[b.model] || 0) + (b.calls - 1);
            }
        }
    }
    const out: Record<string, RunStats> = {};
    for (const [model, usages] of Object.entries(per)) {
        const stats = runStats(usages);
        out[model] = extraCalls[model] ? { ...stats, calls: stats.calls + extraCalls[model] } : stats;
    }
    return out;
}

/** How long a call must have spent loading before it is worth drawing. Ollama reports `load_duration` on
 *  EVERY native call — a few ms when the model was already resident — so without a floor the lane fills with
 *  bars for loads that never happened. A second is well clear of a resident model's bookkeeping and well under
 *  any real load off disk. */
export const LOAD_EVENT_MIN_MS = 1000;

/** The MODEL's own stretch of a call, split by what it was emitting, when that is observable.
 *
 *  Only a STREAMED call can be split: the parsed chunk says which channel each line arrived on, and the SW
 *  marks the changes. A non-streamed call is one response object with one `eval_duration` — we know the
 *  composition of the text but not when the boundary fell, and apportioning by length would be inventing a
 *  timestamp. So it stays one undifferentiated `model` phase, which is the honest shape.
 *
 *  The stretch BEFORE the first mark is also `model`: prompt eval, queue and network are the model's time but
 *  none of its channels.
 *
 *  @param from when the call started (epoch ms)
 *  @param genMs how long it took
 *  @param marks the phase changes, as offsets from `from`
 */
export function genPhases(from: number, genMs: number, marks?: GenPhase[]): NonNullable<ResourceEvent["phases"]> {
    const whole: NonNullable<ResourceEvent["phases"]> = [{ kind: "model", until: from + genMs }];
    if (!marks?.length) return whole;
    const out: NonNullable<ResourceEvent["phases"]> = [];
    if (marks[0].atMs > 0) out.push({ kind: "model", until: from + Math.min(marks[0].atMs, genMs) });
    for (const [i, m] of marks.entries()) {
        const end = Math.min(i + 1 < marks.length ? marks[i + 1].atMs : genMs, genMs);
        // A mark past the end of the call (clock skew, or a final chunk that landed as the call closed)
        // contributes nothing rather than a backwards phase.
        if (end > m.atMs) out.push({ kind: m.kind, until: from + end });
    }
    return out.length ? out : whole;
}

/**
 * The machine's timeline, from what the sessions already recorded. Nothing new is collected:
 *  - a GENERATION span per model call that reported timing — hover it for what it cost;
 *  - a LOAD span for the part of a call that was spent loading the model, when that was a real load;
 *  - a RUN span per agent run, first step to last;
 *  - and, when a `now` is given, the work still IN FLIGHT.
 * Every event carries a `ref` back to the session and step that caused it, because these are CROSS-SESSION:
 * a model load belongs to the box, but you still want to know which chat provoked it.
 *
 * @param sessions the sessions to derive from
 * @param now when the caller is drawing. Given, IN-FLIGHT work is included as OPEN spans reaching `now` — a
 *   generation being generated, a tool running, a human at an approval gate. Omitted (the default), only
 *   FINISHED work is returned, which is what anything durable wants: an export must not contain a span whose
 *   right edge is "when the file was written".
 */
export function eventsFrom(sessions: readonly UsageSource[], now?: number): ResourceEvent[] {
    const out: ResourceEvent[] = [];
    const costOf = (u: TokenUsage): ResourceEvent["cost"] => {
        const s = runStats([u]);
        return {
            inTokens: s.inTokens, outTokens: s.outTokens, tokPerSec: s.tokPerSec, genBasis: s.genBasis,
            // Both timings ride along when both exist: their difference is the network and the queue, which is
            // a different diagnosis from a slow model and cannot be recovered from the rate alone.
            ...(u.evalMs != null ? { evalMs: u.evalMs } : {}),
            ...(u.genMs != null ? { wallMs: u.genMs } : {}),
            ...(u.promptEvalMs != null ? { promptEvalMs: u.promptEvalMs } : {}),
        };
    };
    const call = (ts: number | undefined, u: TokenUsage | null | undefined, model: string | null | undefined,
                  ref: ResourceEvent["ref"], id?: string, parent?: string) => {
        if (!ts || !u) return;
        // The timestamp we have is when the call FINISHED (the event is emitted with its result), so a span
        // runs backwards from it: that is where the time actually went.
        const genMs = u.genMs ?? u.evalMs ?? 0;
        const loadMs = u.loadMs ?? 0;
        if (genMs > 0) {
            out.push({ t: ts - genMs, until: ts, kind: "gen", label: model || "generation",
                       model: model || undefined, ...(id ? { id } : {}), ...(parent ? { parent } : {}), ref,
                       phases: genPhases(ts - genMs, genMs, u.genPhases), cost: costOf(u) });
        }
        // The load happened at the START of the call, before a token was generated — drawn as its own span so
        // "the turn was slow" and "the model wasn't there yet" are visibly different answers.
        if (loadMs >= LOAD_EVENT_MIN_MS) {
            const from = ts - Math.max(genMs, loadMs);
            out.push({ t: from, until: from + loadMs, kind: "load", label: `loading ${model || "model"}`,
                       model: model || undefined, ref });
        }
    };
    for (const s of sessions) {
        const runId = `run:${s.hash}`;
        for (const t of s.turns || []) call(t.ts, t.usage, t.model || s.model, { hash: s.hash });
        const steps = s.steps || [];
        // A turn's USAGE rides its thought record, not the tool call it decided on: the loop emits the
        // model's prose/usage as one record and each tool call as another, and only the second has a `seq`.
        // So the model's half of a composite block has to be looked up ACROSS records — reading `st.usage` on
        // the tool record alone finds nothing, and the block silently loses the phase it exists to show.
        // (It looked right for a long time because the demo fabricates both on one record. A shape the
        // product never emits is exactly the thing a demo must not invent.)
        const turnUsage = new Map<number, typeof steps[number]>();
        const toolsPerTurn = new Map<number, number>();
        for (const st of steps) {
            const k = st.step ?? 0;
            if (st.tool && st.toolMs != null && st.ts) toolsPerTurn.set(k, (toolsPerTurn.get(k) || 0) + 1);
            else if (st.usage && !st.tool) turnUsage.set(k, st);
        }
        // Folded only when the turn made exactly ONE call. Several tool calls share one generation, so
        // charging it to each would draw the same seconds two or three times; those turns keep the
        // generation as its own `gen` span, which is the only honest shape for work that fans out.
        const folded = new Set([...toolsPerTurn].filter(([k, n]) => n === 1 && turnUsage.has(k)).map(([k]) => k));
        for (const st of steps) {
            // A TOOL step is one composite span: the model generating the call, then the tool running it. One
            // block, because it is one step and you read the two halves against each other — but split, so
            // "the model was slow" and "the tool was slow" are different shapes rather than one long bar.
            if (st.tool && st.toolMs != null && st.ts) {
                const turnU = st.usage ?? (folded.has(st.step ?? 0) ? turnUsage.get(st.step ?? 0)!.usage : null);
                const genMs = turnU?.genMs ?? turnU?.evalMs ?? 0;
                const waitMs = st.approveMs ?? 0;
                // PLUMBING between the model finishing and the tool starting. Counted in the block's extent
                // rather than left out: the start is reconstructed by subtracting the parts we know about, so
                // an unmeasured part shifts the whole block LATER than the work happened — which, on an axis
                // shared with the memory trace, draws a block after the memory movement it caused.
                const dispatchMs = st.dispatchMs ?? 0;
                const from = st.ts - st.toolMs - waitMs - genMs - dispatchMs;
                // Four kinds of time, in the order they happened: the model, the plumbing, the human, the
                // tool. Only the first and last are work; the middle two are a step getting from one to the
                // other, and one of them is a person deciding, which is often the largest of all.
                const phases: NonNullable<ResourceEvent["phases"]> = [];
                // The model's own stretch subdivides further on a streamed call — thinking, then the tool-call
                // fragments, and back again if it interleaved.
                if (genMs > 0) phases.push(...genPhases(from, genMs, turnU?.genPhases));
                if (dispatchMs > 0) phases.push({ kind: "dispatch", until: from + genMs + dispatchMs });
                if (waitMs > 0) phases.push({ kind: "wait", until: from + genMs + dispatchMs + waitMs });
                // A REMOTE tool splits further, and only because it reported its own numbers: what it spent
                // evaluating, what it spent getting started, and — by subtraction — what the network cost.
                // Drawn network-FIRST: the request has to get there before anything else happens, and the
                // return leg is folded in with it because nothing measures the two halves separately.
                const rm = st.remoteMs;
                const toolStart = from + genMs + dispatchMs + waitMs;
                if (rm && rm.durationMs >= 0 && st.toolMs != null && rm.durationMs <= st.toolMs) {
                    const q = Math.max(0, Math.min(rm.queuedMs ?? 0, st.toolMs - rm.durationMs));
                    const net = Math.max(0, st.toolMs - rm.durationMs - q);
                    if (net > 0) phases.push({ kind: "net", until: toolStart + net });
                    if (q > 0) phases.push({ kind: "queue", until: toolStart + net + q });
                }
                phases.push({ kind: "tool", until: st.ts });
                const stepId = `step:${s.hash}:${st.seq ?? st.step ?? 0}`;
                out.push({
                    t: from, until: st.ts, phases, kind: "tool",
                    label: st.tool, tool: st.tool, model: s.model || undefined,
                    id: stepId, parent: runId,
                    ref: { hash: s.hash, seq: st.seq },
                    ...(turnU ? { cost: costOf(turnU) } : {}),
                });
                // Delegated sub-calls (a vision reader today, a background embedding when that lands) are
                // spawned BY this step and are drawn as their own spans under it — a different model doing
                // different work, which the step's own block cannot say.
                for (const [i, sc] of (st.subUsage?.calls_ || []).entries()) {
                    out.push({
                        t: sc.ts - (sc.ms || 0), until: sc.ts, kind: "embed", label: sc.model, model: sc.model,
                        id: `${stepId}:sub${i}`, parent: stepId, ref: { hash: s.hash, seq: st.seq },
                        // No OUTPUT tokens, no rate. An embedding call generates none, and "0 tok/s" reads as a
                        // model that produced nothing slowly rather than a measure that does not apply to it.
                        cost: { inTokens: sc.prompt, outTokens: sc.completion,
                                tokPerSec: sc.ms > 0 && sc.completion > 0 ? sc.completion / (sc.ms / 1000) : null,
                                genBasis: sc.ms > 0 && sc.completion > 0 ? "wall" : null },
                    });
                }
                // Its own load, if this call had to wait for the model to arrive, stays a separate span: it
                // happened before a token was generated, and burying it inside the block would hide the one
                // thing that explains a slow turn.
                if ((turnU?.loadMs ?? 0) >= LOAD_EVENT_MIN_MS) {
                    const lFrom = from - (turnU!.loadMs as number);
                    out.push({ t: lFrom, until: from, kind: "load", label: `loading ${s.model || "model"}`,
                               model: s.model || undefined, ref: { hash: s.hash, seq: st.seq } });
                }
                continue;
            }
            // Folded into the tool block above → drawing it again here would double the same seconds.
            if (!st.tool && folded.has(st.step ?? 0) && turnUsage.get(st.step ?? 0) === st) continue;
            call(st.ts, st.usage, s.model, { hash: s.hash, seq: st.seq }, `step:${s.hash}:${st.seq ?? st.step ?? 0}`, runId);
        }
        // ── IN FLIGHT ────────────────────────────────────────────────────────────────────────────────
        // Everything above is history: it is derived from a step's FINISH stamp, so none of it exists until
        // the work is over, and then it appears back-dated across memory the chart already drew. These are the
        // same spans while they are still happening. They are OPEN — `until` is where they had reached, not
        // where they ended — and they exist only for a caller that said what time it is.
        if (now != null) {
            // The model is generating right now. Its phases come along when the run streams, so a live bar
            // gains its dividers as the model crosses from thinking to answering rather than at the end.
            const lt = s.liveTurn;
            if (lt && lt.startedTs <= now) {
                out.push({ t: lt.startedTs, until: now, open: true, kind: "gen",
                           label: s.model ? `${s.model} · generating` : "generating", model: s.model || undefined,
                           id: `live:${s.hash}`, parent: runId, ref: { hash: s.hash },
                           phases: genPhases(lt.startedTs, now - lt.startedTs, lt.phases) });
            }
            for (const st of steps) {
                // A pending step's `ts` is when it STARTED — the opposite of a finished one's — so this span is
                // built FORWARDS. `awaitingApproval` is the same shape with a different meaning: what is
                // elapsing is a person deciding, which is the step's wall clock but not the machine's work.
                if (!st.pending || !st.ts || st.ts > now) continue;
                const waiting = !!st.awaitingApproval;
                out.push({ t: st.ts, until: now, open: true, kind: "tool",
                           label: waiting ? `${st.tool || "tool"} · awaiting approval` : `${st.tool || "tool"} · running`,
                           tool: st.tool, model: s.model || undefined,
                           id: `step:${s.hash}:${st.seq ?? st.step ?? 0}`, parent: runId,
                           ref: { hash: s.hash, seq: st.seq },
                           phases: [{ kind: waiting ? "wait" : "tool", until: now }] });
            }
        }
        // The run itself, so a generation can be read against the turn that contained it.
        const stamps = steps.map((st) => st.ts).filter((t): t is number => !!t);
        // Bounded by the session's own start/end where they exist: a step stamp is an END, so the run would
        // otherwise begin after its first call finished.
        if (s.createdTs) stamps.push(s.createdTs);
        if (s.lastTs) stamps.push(s.lastTs);
        if (stamps.length > 1) {
            // The run's own cost is the sum of its steps — a container bar with nothing to read is just a
            // shape, and this is the one place the whole turn's spend is visible against the memory trace.
            const runCost = runStats(steps.map((st) => st.usage));
            const live = now != null && (s.liveTurn || steps.some((st) => st.pending));
            // A live run's container must reach `now`, or the open spans inside it stick out past the bar that
            // is supposed to contain them. Only the END is extended: a run STARTED when it started, and letting
            // `now` into the minimum would make a clock that disagrees with the run's own stamps move its
            // beginning — which is how a skewed reading turns into a span that runs backwards.
            const until = Math.max(...stamps, ...(live ? [now] : []));
            // A container is a RUN only when the session IS an agent run. Testing for `kind === "chat"`
            // instead never fired: the reducer sets `kind` on an agent session and leaves it UNSET on a chat,
            // so every container stayed a run and the lane's counter credited an embedding model with runs it
            // never had. Absence of the marker is the chat case, not a third state.
            out.push({ t: Math.min(...stamps), until, kind: s.kind === "agent" ? "run" : "session",
                       ...(live ? { open: true as const } : {}),
                       label: `${s.kind === "agent" ? "run" : s.kind === "embed" ? "embed" : "chat"}${s.model ? ` · ${s.model}` : ""}`,
                       model: s.model || undefined,
                       id: runId, ref: { hash: s.hash },
                       ...(runCost.calls ? { cost: { inTokens: runCost.inTokens, outTokens: runCost.outTokens,
                                                     tokPerSec: runCost.tokPerSec, genBasis: runCost.genBasis } } : {}) });
        }
    }
    return out.sort((a, b) => a.t - b.t);
}
