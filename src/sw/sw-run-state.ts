// sw-run-state.ts — DUMP_RUN_STATE: the state inspector's read of one run, assembled from the state registry
// (state-registry.ts) in the worker. Extension pages only, like DUMP_RUN_LOG: the grants and the mailbox are the
// person's to see, and a page could otherwise read another tab's run.

import { declaredState, readState, type StateEntry, type StateScope, type StateLoss } from "../state-registry";
import { hydrationDone, stateKeyFor } from "./sw-runs";
import { senderOrigin } from "./sw-housekeeping";

/** A declared member, whether or not it holds anything for this run, so the pane can show an empty one as empty. */
export interface RunStateMember {
    id: string;
    scope: StateScope;
    audience: "model" | "human";
    lostOn: StateLoss[];
    describe: string;
}

/** What DUMP_RUN_STATE answers with. */
export interface RunStateDump {
    /** When it was read: the pane says how old what it shows is. */
    ts: number;
    /** Every member this worker declares that a person may see, in id order. */
    members: RunStateMember[];
    /** What the members that hold something for this run hold. */
    entries: StateEntry[];
}

/** DUMP_RUN_STATE: every readable member of one run's state, as of now. */
export async function handleRunStateDump(payload: unknown, sender: chrome.runtime.MessageSender): Promise<{ data?: RunStateDump; error?: string }> {
    if (senderOrigin(sender) === "page") return { error: "Refused: the run's state is for extension pages." };
    const run = typeof (payload as { run?: unknown } | null)?.run === "string" ? (payload as { run: string }).run : "";
    // On a fresh worker the run maps are empty until hydration settles, which would read as "this run holds nothing".
    await hydrationDone;
    const members = declaredState().filter((d) => d.read && d.audience !== "never")
        .map((d): RunStateMember => ({ id: d.id, scope: d.scope, audience: d.audience as "model" | "human", lostOn: [...d.lostOn], describe: d.describe }));
    return { data: { ts: Date.now(), members, entries: run ? await readState(stateKeyFor(run), "human") : [] } };
}
