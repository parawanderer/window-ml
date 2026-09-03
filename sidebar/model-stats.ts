// What each model has COST this browsing session, and what happened on the machine's timeline.
//
// Residency (the resource panel's other half) answers "what is loaded". This answers "and was it worth the
// VRAM": tokens in and out, how many calls, and the rate — with `genBasis` saying whether that rate came from
// Ollama's own generation timings or from wall clock, because a number that silently mixes the two implies a
// precision it does not have.
//
// Pure, and deliberately over a MINIMAL shape rather than the sidebar's Session type: the aggregation is the
// part worth testing, and it should not need a whole debug-event fixture to exercise.
import { runStats, type RunStats, type TokenUsage } from "../contract";
import type { ResourceEvent } from "../resource-model";

/** The little a session must expose for these to work. */
export interface UsageSource {
    hash: string;
    /** The model the run/chat resolved to — the fallback owner of any usage a turn doesn't name itself. */
    model?: string | null;
    createdTs?: number;
    turns?: { ts?: number; model?: string | null; usage?: TokenUsage | null }[];
    steps?: {
        seq?: number; step?: number; ts?: number;
        tool?: string;
        /** How long the tool itself ran (the loop measures it around the dispatch, excluding the gate). */
        toolMs?: number;
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

/** The machine's timeline, from what the sessions already recorded. Nothing new is collected:
 *  - a GENERATION span per model call that reported timing — hover it for what it cost;
 *  - a LOAD span for the part of a call that was spent loading the model, when that was a real load;
 *  - a RUN span per agent run, first step to last.
 *  Every event carries a `ref` back to the session and step that caused it, because these are CROSS-SESSION:
 *  a model load belongs to the box, but you still want to know which chat provoked it. */
export function eventsFrom(sessions: readonly UsageSource[]): ResourceEvent[] {
    const out: ResourceEvent[] = [];
    const costOf = (u: TokenUsage): ResourceEvent["cost"] => {
        const s = runStats([u]);
        return { inTokens: s.inTokens, outTokens: s.outTokens, tokPerSec: s.tokPerSec, genBasis: s.genBasis };
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
                       model: model || undefined, ...(id ? { id } : {}), ...(parent ? { parent } : {}), ref, cost: costOf(u) });
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
        for (const st of steps) {
            // A TOOL step is one composite span: the model generating the call, then the tool running it. One
            // block, because it is one step and you read the two halves against each other — but split, so
            // "the model was slow" and "the tool was slow" are different shapes rather than one long bar.
            if (st.tool && st.toolMs != null && st.ts) {
                const genMs = st.usage?.genMs ?? st.usage?.evalMs ?? 0;
                const waitMs = st.approveMs ?? 0;
                const from = st.ts - st.toolMs - waitMs - genMs;
                // Three kinds of time, in the order they happened: the model, the human, the tool. Only the
                // first and last are work; the middle is a person deciding, and it is often the largest.
                const phases: NonNullable<ResourceEvent["phases"]> = [];
                if (genMs > 0) phases.push({ kind: "model", until: from + genMs });
                if (waitMs > 0) phases.push({ kind: "wait", until: from + genMs + waitMs });
                phases.push({ kind: "tool", until: st.ts });
                const stepId = `step:${s.hash}:${st.seq ?? st.step ?? 0}`;
                out.push({
                    t: from, until: st.ts, phases, kind: "tool",
                    label: st.tool, tool: st.tool, model: s.model || undefined,
                    id: stepId, parent: runId,
                    ref: { hash: s.hash, seq: st.seq },
                    ...(st.usage ? { cost: costOf(st.usage) } : {}),
                });
                // Delegated sub-calls (a vision reader today, a background embedding when that lands) are
                // spawned BY this step and are drawn as their own spans under it — a different model doing
                // different work, which the step's own block cannot say.
                for (const [i, sc] of (st.subUsage?.calls_ || []).entries()) {
                    out.push({
                        t: sc.ts - (sc.ms || 0), until: sc.ts, kind: "embed", label: sc.model, model: sc.model,
                        id: `${stepId}:sub${i}`, parent: stepId, ref: { hash: s.hash, seq: st.seq },
                        cost: { inTokens: sc.prompt, outTokens: sc.completion,
                                tokPerSec: sc.ms > 0 ? sc.completion / (sc.ms / 1000) : null,
                                genBasis: sc.ms > 0 ? "wall" : null },
                    });
                }
                // Its own load, if this call had to wait for the model to arrive, stays a separate span: it
                // happened before a token was generated, and burying it inside the block would hide the one
                // thing that explains a slow turn.
                if ((st.usage?.loadMs ?? 0) >= LOAD_EVENT_MIN_MS) {
                    const lFrom = from - (st.usage!.loadMs as number);
                    out.push({ t: lFrom, until: from, kind: "load", label: `loading ${s.model || "model"}`,
                               model: s.model || undefined, ref: { hash: s.hash, seq: st.seq } });
                }
                continue;
            }
            call(st.ts, st.usage, s.model, { hash: s.hash, seq: st.seq }, `step:${s.hash}:${st.seq ?? st.step ?? 0}`, runId);
        }
        // The run itself, so a generation can be read against the turn that contained it.
        const stamps = steps.map((st) => st.ts).filter((t): t is number => !!t);
        if (stamps.length > 1) {
            out.push({ t: Math.min(...stamps), until: Math.max(...stamps), kind: "run",
                       label: s.model ? `run · ${s.model}` : "run", model: s.model || undefined,
                       id: runId, ref: { hash: s.hash } });
        }
    }
    return out.sort((a, b) => a.t - b.t);
}
