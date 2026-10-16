// sw-asks.ts — nested asks: a call made from INSIDE a running step that needs the person, raised as a card inside that
// step and answered like any other approval.

// docs/spec/ML_WIRE.md, "Per-call asking" (ruled 2026-10-15). Every other gate is raised by the agent loop BEFORE a tool
// runs, keyed `${runId}:${seq}`, and is the step's own pending event. A call made while the step runs (an `ml.sh` from an
// approved exec, a gated `ml` member from a Python cell, a policy with no opinion inside a survey) has no gate to open, so
// the step gains `asks[]`, each kept in the same pending-approvals store under `${runId}:${seq}#${askId}` and answered by
// the same SET_APPROVAL / `approval.answer`, with the ask id beside the seq. One mechanism, several consumers: this file
// knows nothing about what is asked; the consumer hands it the policy's `c` as `facts` (one shape for the card, a policy
// and the log) and gets back whether the person allowed it.
//
// What the person is shown is the step's own event, re-emitted with its asks, so every surface that renders a step (the
// sidebar, the DevTools panel, the chat page, the phone over the hub) renders the ask with no new message type.

import type { EffectsData, Placement } from "../effects";
import type { AskState, StepAsk } from "../contract";
export type { AskState, StepAsk };
import { pendingApprovals, type PendingApprovalDescriptor } from "./sw-consent";
import type { PolicyConsumer } from "./sw-policies";
import { recordRunLog } from "./sw-run-log";
export { ASK_ID, approvalKey } from "../approval-key";

/** What the consumer gets back. `waitedMs` is the wall-clock time the call waited, which its result says: a reading
 *  taken after the wait is not simultaneous with one taken before. A refusal that waited for nobody (`unattended`, and
 *  the instant `ended`/`limit` ones) answers at the raise time and reports 0. */
export interface AskOutcome { allowed: boolean; state: Exclude<AskState, "pending">; note?: string; raisedAt: number; answeredAt: number; waitedMs: number }

/** How long an ask waits for the person before it is denied (the wall clock runs while a script waits; its step budget
 *  does not). Five minutes, the `ml` wire's ASK_TIMEOUT_MS. */
export const ASK_WAIT_MS = 5 * 60_000;

/** The most asks one step may raise. Each waits for the person in turn, so a script looping over a call would otherwise
 *  stack cards without end; past it the call is refused without one. */
export const MAX_ASKS_PER_STEP = 64;

/** What the run hosting a step offers its asks: who to tell, whether anyone is there, and when the run ends. */
export interface AskRun {
    runId: string;
    /** No person is attached (a scheduled or delegated run): every ask is refused at once. */
    unattended: boolean;
    routing: "ui" | "both" | "external";
    /** Re-emit step `seq` (the OFFSET seq every surface sees) with its asks. */
    emit: (seq: number, asks: StepAsk[]) => void;
    /** Whether `seq` is a step of this turn that is running now, which a surface has drawn: an ask anywhere else would
     *  wait where nobody can see it. */
    running: (seq: number) => boolean;
    /** The run's step counter for `seq`, for the descriptor. */
    stepOf: (seq: number) => number;
    /** Aborted when the run is cancelled. */
    signal: AbortSignal;
    /** Override {@link ASK_WAIT_MS}, for tests. */
    waitMs?: number;
}

const runs = new Map<string, AskRun>();   // state: plumbing — the runs a turn is hosting now; a consumer finds its run here, and an evicted worker has none, so an ask then cannot be raised (fails closed)
const enders = new Map<string, (state: "ended", note: string) => void>();   // state: plumbing — how each pending ask is ended without the person, by its key
const asksByStep = new Map<string, StepAsk[]>();   // state: plumbing — each running step's asks, history included, so a re-emit carries them all; pending ones are `run.approvals`, and the history is on the step event

/**
 * Let a run's steps raise asks for the length of a turn.
 * @param run the run
 * @returns call when the turn settles: every ask still pending ends (`ended`), and none can be raised after
 */
export function hostAsks(run: AskRun): () => void {
    runs.set(run.runId, run);
    return () => {
        if (runs.get(run.runId) === run) runs.delete(run.runId);
        for (const [key, end] of [...enders]) if (key.startsWith(`${run.runId}:`)) end("ended", "the run's turn ended before anyone answered");
        for (const k of [...asksByStep.keys()]) if (k.startsWith(`${run.runId}:`)) asksByStep.delete(k);
    };
}

/**
 * A running step's asks so far, as plain copies, for every later event of that step.
 * @param runId the run
 * @param seq the step's OFFSET seq
 */
export function stepAsks(runId: string, seq: number): StepAsk[] | undefined {
    return asksByStep.get(`${runId}:${seq}`)?.map((a) => ({ ...a }));
}

/** Whether a run can raise asks now (it is hosted by this worker and its turn is running). */
export const canAsk = (runId: string): boolean => runs.has(runId);

/** What a consumer asks: the kind of call and its facts. A call a policy store judges names its consumer, and then its
 *  facts must carry `effects` (sw-consent.ts, PendingApprovalDescriptor). */
export type AskRequest = { kind: string; placement?: Placement } & (
    | { consumer: PolicyConsumer; facts: Record<string, unknown> & { effects: EffectsData } }
    | { consumer?: undefined; facts: Record<string, unknown> }
);

/**
 * Raise one nested ask on a running step and wait for the person. Never throws: every way it can end is an outcome.
 * @param runId the run (the consumer's own, already verified by its sender; never one a script named)
 * @param seq the OFFSET seq of the step the call is made from
 * @param ask what kind of call, its facts (the policy's `c`), and the consumer and placement a policy is judged with
 * @returns the outcome
 */
export function raiseAsk(runId: string, seq: number, ask: AskRequest): Promise<AskOutcome> {
    const raisedAt = Date.now();
    const run = runs.get(runId);
    const ended = (state: AskOutcome["state"], note: string): AskOutcome => ({ allowed: false, state, note, raisedAt, answeredAt: raisedAt, waitedMs: 0 });
    if (!run || run.signal.aborted) return Promise.resolve(ended("ended", "the run is not running here"));
    if (!run.running(seq)) return Promise.resolve(ended("ended", "no step of this run is running under that seq"));
    const stepKey = `${runId}:${seq}`;
    const list = asksByStep.get(stepKey) ?? [];
    asksByStep.set(stepKey, list);
    const id = `a${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const entry: StepAsk = { id, kind: String(ask.kind), facts: plainCopy(ask.facts), state: "pending", raisedAt, ...(run.routing === "external" ? { external: true as const } : {}) };
    const settle = (e: StepAsk, state: AskOutcome["state"], note?: string, instant = false): AskOutcome => {
        e.state = state;
        // An instant refusal answers at the raise time, as `ended()` does: there was no wait to measure, and a
        // second `Date.now()` is not simultaneous with the first, so measuring one would report a phantom millisecond.
        e.answeredAt = instant ? raisedAt : Date.now();
        if (note) e.note = note.slice(0, 2000);
        run.emit(seq, list.map((a) => ({ ...a })));
        recordRunLog(runId, { ...(state === "allowed" ? {} : { level: "warn" as const }), subsystem: "consent", kind: "ask", reason: state, ms: e.answeredAt - raisedAt, detail: { kind: e.kind, seq } });
        return { allowed: state === "allowed", state, ...(e.note ? { note: e.note } : {}), raisedAt, answeredAt: e.answeredAt, waitedMs: e.answeredAt - raisedAt };
    };
    if (list.length >= MAX_ASKS_PER_STEP) {
        // Not recorded on the step: a script past the cap would otherwise grow the event without end.
        recordRunLog(runId, { level: "warn", subsystem: "consent", kind: "ask", reason: "limit", detail: { kind: entry.kind, seq } });
        return Promise.resolve(ended("limit", `this step already asked ${MAX_ASKS_PER_STEP} times; make fewer calls that need approval in one step`));
    }
    list.push(entry);
    if (run.unattended) return Promise.resolve(settle(entry, "unattended", "this run has nobody to ask", true));
    const key = `${stepKey}#${id}`;
    return new Promise<AskOutcome>((resolve) => {
        let done = false;
        const finish = (state: AskOutcome["state"], note?: string): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            run.signal.removeEventListener("abort", onAbort);
            enders.delete(key);
            if (pendingApprovals.get(key)?.descriptor === descriptor) pendingApprovals.delete(key);
            resolve(settle(entry, state, note));
        };
        const onAbort = (): void => finish("cancelled", "the run was cancelled");
        const timer = setTimeout(() => finish("timeout", "nobody answered in time"), run.waitMs ?? ASK_WAIT_MS);
        run.signal.addEventListener("abort", onAbort);
        enders.set(key, finish);
        const base = { key, runId, seq, step: run.stepOf(seq), tool: entry.kind, arguments: entry.facts, ts: raisedAt, routing: run.routing, askId: id, ...(ask.placement ? { placement: ask.placement } : {}) };
        // The copy keeps `effects` (plainCopy is JSON, and EffectsData is plain data), so a judged consumer's card stays
        // judgeable; a copy that lost them (facts that would not serialise) is left to the person, never judged blind.
        const descriptor: PendingApprovalDescriptor = ask.consumer && entry.facts.effects !== undefined
            ? { ...base, consumer: ask.consumer, facts: entry.facts as Record<string, unknown> & { effects: EffectsData } }
            : { ...base, facts: entry.facts };
        pendingApprovals.set(key, {
            descriptor,
            resolve: (d) => {
                const o = typeof d === "object" && d ? d : { approved: !!d };
                if (o.cancelled) return finish("cancelled", o.feedback || "the run was cancelled");
                finish(o.approved ? "allowed" : "denied", o.approved ? undefined : o.feedback);
            },
        });
        // Shown only once it can be answered: an approver that answers at once (an external one, a surface on the same
        // turn of the event loop) must find the gate registered.
        run.emit(seq, list.map((a) => ({ ...a })));
    });
}

/**
 * A plain-data copy: what a surface draws and an export writes must not be a live object of the consumer's.
 * @param v the facts
 */
function plainCopy(v: Record<string, unknown>): Record<string, unknown> {
    try { return JSON.parse(JSON.stringify(v ?? {})) as Record<string, unknown>; } catch { return {}; }
}
