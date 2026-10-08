// page-run-state.ts — the state of a run whose loop runs IN THE PAGE (a page-hosted run: a site trusted to gate its own
// approvals, or a run with nothing to gate), declared in the page's state registry so the state inspector can read it.
// A background-hosted run's state is the worker's (sw-runs.ts); this is the same members, held by the page instead.
//
// The ids match the worker's on purpose: they are the same members of the same kind of run. The worker accepts the
// page's answer for one of its own ids only for a run its session index says the page hosts (sw-run-state.ts).

import { defineState } from "../state-registry";
import type { AgentControl } from "../ml/ml-agent";
import type { CurrentSnapshot } from "./current-context";
import { contextTextOf, messageRow, pointerRow } from "./state-rows";
import type { AnswerSet } from "../pointers/answer-set";

/** What the page keeps for one page-hosted run: its control (history, inbox, pointer store) and, while a turn runs, the
 *  loop's context snapshot. */
interface PageHostedRun {
    control: AgentControl;
    answer?: AnswerSet;
    context?: () => CurrentSnapshot;
}

/** Page-hosted runs by id, for as long as the page keeps their handles (it never drops those either: `agentRegistry`). */
const pageHosted = new Map<string, PageHostedRun>();

/**
 * Note a run whose loop this page hosts, so its state can be read.
 * @param runId the run's id (its session hash)
 * @param control the run's control object, read live
 * @param answer the run's answer set
 */
export function trackPageHosted(runId: string, control: AgentControl, answer: AnswerSet): void {
    const had = pageHosted.get(runId);
    pageHosted.set(runId, { ...had, control, answer });
}

/**
 * The loop's context snapshot for a page-hosted run's current turn (agent-loop.ts `contextSink`).
 * @param runId the run
 * @param fn the snapshot function, or undefined when the turn ends
 */
export function setPageContext(runId: string, fn: (() => CurrentSnapshot) | undefined): void {
    const r = pageHosted.get(runId);
    if (r) r.context = fn;
}

/** A page-hosted run's answer set while a turn runs, for `run.answer` (run-delegation.ts), which a delegated run's
 *  answer set shares. Between turns the set still holds the last turn's answer, which has already been handed over. */
export const pageHostedAnswer = (runId: string): AnswerSet | undefined => {
    const r = pageHosted.get(runId);
    return r?.context ? r.answer : undefined;
};

defineState({
    id: "run.messages", scope: "session", realm: "page", audience: "model", lostOn: ["navigation"], exposedAs: "ml.current.messages",
    describe: "The context the run's next model call gets, one row per message, each cut to a preview. Between turns, the history the run kept for a follow-up.",
    read: ({ runId }) => {
        const r = runId ? pageHosted.get(runId) : undefined;
        return r ? (r.context?.().messages ?? r.control.messages).map(messageRow) : undefined;
    },
});
defineState({
    id: "run.meta", scope: "run", realm: "page", audience: "model", lostOn: ["navigation", "turn-end"], exposedAs: "ml.current.meta",
    describe: "What is known about each message of the live context, in the same order: its id, size in tokens, when it arrived, from which step and tool.",
    read: ({ runId }) => (runId ? pageHosted.get(runId)?.context?.().meta : undefined),
});
defineState({
    id: "run.current", scope: "run", realm: "page", audience: "model", lostOn: ["navigation", "turn-end"], exposedAs: "ml.current.run",
    describe: "The live turn as the model sees it: the run's id, its model, the step it is on, its step budget, and when it started.",
    read: ({ runId }) => (runId ? pageHosted.get(runId)?.context?.().run : undefined),
});
defineState({
    id: "run.pointers", scope: "session", realm: "page", audience: "model", lostOn: ["navigation"],
    describe: "The run's `@tool:` values: what each tool call returned, addressable by id, label or tool name.",
    read: ({ runId }) => {
        const r = runId ? pageHosted.get(runId) : undefined;
        const all = r?.control.tokens?.all();
        if (!r || !all) return undefined;
        const text = contextTextOf(r.context?.().messages ?? r.control.messages);
        return all.map((v) => pointerRow(v, text));
    },
});
defineState({
    id: "run.mailbox", scope: "run", realm: "page", audience: "human", lostOn: ["navigation"],
    describe: "Messages sent to the run that it has not read yet; it reads them at its next step.",
    read: ({ runId }) => (runId ? pageHosted.get(runId)?.control.inbox.map((m) => ({ text: m.text, origin: m.origin ?? null })) : undefined),
});
