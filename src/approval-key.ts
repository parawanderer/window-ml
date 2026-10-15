// approval-key.ts — the key an approval answer resolves: a step's own gate, or a nested ask inside it.

// One rule for every surface that answers a gate (SET_APPROVAL from the sidebar and the DevTools panel, `approval.answer`
// from the chat page, the phone and the hub), so a malformed ask id is refused the same way everywhere
// (docs/spec/ML_WIRE.md, "Per-call asking"; src/sw/sw-asks.ts raises the asks).

/** A nested ask's id: `a` and 24 hex digits, unguessable, and the only shape an answer may name. */
export const ASK_ID = /^a[0-9a-f]{24}$/;

/**
 * The key an answer resolves: the step's, plus the ask's when it names one. An ask id of the wrong shape names nothing,
 * so a forged one resolves no gate, not even the step's own.
 * @param runId the run
 * @param seq the step's seq
 * @param ask the ask id, if the answer is for one (absent: the step's own gate; anything else present, null included,
 *   must be a well-formed id)
 * @returns the key, or null when `ask` is present but malformed
 */
export function approvalKey(runId: string, seq: number, ask?: unknown): string | null {
    if (ask === undefined) return `${runId}:${seq}`;
    return typeof ask === "string" && ASK_ID.test(ask) ? `${runId}:${seq}#${ask}` : null;
}

/**
 * The SET_APPROVAL payload the sidebar's two hosts (the overlay's shell, the DevTools panel) send for an answer their
 * own app posted: rebuilt field by field from what the app said, so nothing else it carried crosses. The two hosts
 * built it separately before, and both dropped the denial's note.
 * @param d the app's message, already checked to come from the app's own frame and to name a run and a seq
 * @returns the payload
 */
export function approvalPayload(d: { hash: string; seq: number; decision?: unknown; persist?: unknown; feedback?: unknown; ask?: unknown }): import("./contract").SetApprovalPayload {
    return {
        runId: d.hash, seq: d.seq, decision: !!d.decision, persist: !!d.persist,
        ...(typeof d.feedback === "string" && d.feedback ? { feedback: d.feedback.slice(0, 2000) } : {}),
        // Present means an ask was meant, whatever its type: the worker's approvalKey refuses a malformed one. Dropping it
        // here would turn the answer into one for the step's own gate.
        ...(d.ask !== undefined ? { ask: d.ask as string } : {}),
    };
}
